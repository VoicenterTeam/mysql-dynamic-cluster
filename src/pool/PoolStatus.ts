/**
 * Created by Bohdan on Sep, 2021
 */

import { GlobalStatusResult, ICheckOutcome, IQueryOptions } from "../types/PoolInterfaces";
import Logger from "../utils/Logger";
import Events from "../utils/Events";
import { Utils } from "../utils/Utils";
import { Timer } from "../utils/Timer";
import { Pool } from "./Pool";
import { Validator } from "./Validator";
import { LoadFactor } from "./LoadFactor";
import {
    IHealthCheck, ITimerCheckRange, IUserPoolSettings
} from "../types/PoolSettingsInterfaces";
import { Settings } from "../utils/Settings";
import { QueryTimer } from "../utils/QueryTimer";
import { INodeCheckError } from "../types/NodeInterfaces";
import Metrics from "../metrics/Metrics";
import { HealthCheckResult } from "../types/MetricsInterfaces";

// why passive health took a node down, as the log names it
type PassiveReason = 'passive_connect' | 'passive_lost' | 'passive_timeout'
    | 'passive_unreachable';

export class PoolStatus {
    public active: boolean;
    // Connections that can still be handed out, read from the pool
    public get availableConnectionCount(): number {
        return this._pool.availableConnectionCount;
    }
    // How much time query take. Time in seconds

    private readonly _pool: Pool;
    // Check if valid by passed validator
    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }

    private _queryTime: number;
    get queryTime(): number {
        return this._queryTime;
    }

    // Score from load factor
    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }
    private _validator: Validator;
    private _loadFactor: LoadFactor;
    // Failed checks in a row. One failure (network blip) doesn't take the pool out of rotation
    // With a healthCheck block a refused login is the exception: it takes the pool out at once
    // and slows the next checks down
    private _failedChecks: number = 0;
    // How many of them take the pool out of rotation
    private readonly _fall: number;
    // Passed checks in a row. Only a node with a healthCheck block reads it
    private _passedChecks: number = 0;
    // Whether a check passed since the last startTimerCheck(), so since connect(). Read
    // with a healthCheck block only, as the count above
    private _passedSinceStart: boolean = false;
    // Whether the next check waits authRetryInterval: the server refused a check, and no
    // check since got an answer that is no refusal. Only a node with a healthCheck block
    // ever has it set. See _unanswered()
    private _slowRetry: boolean = false;
    // How many checks of this run are out. More than one after a connect() on a pool that
    // is connected: its check and the one of the timer. stopTimerCheck() starts it at 0,
    // and a check from before that never counts down
    private _checksOut: number = 0;
    // How many checks have to start before passive health may start one again: the one it
    // started and the next one of the timer. So it starts one check at most between two
    // checks of the timer, however many queries of the app fail
    private _holdOff: number = 0;
    // Set when a call of the app lost its connection, got none within the connect timeout
    // or found no route, since the last check that got its answer: which of the three it
    // was. The next check that fails takes the node down, whatever `fall` is
    private _decides?: 'lost' | 'timeout' | 'unreachable';
    // How many times in a row the check that decides ran again, because it met a
    // connection that was lost itself. 0 outside such a row
    private _reruns: number = 0;
    // The most of them. See _metLostConnection()
    private readonly _rerunLimit: number;
    // The code of the last connection error of the app that passive health acted on, for
    // the log
    private _passiveCode?: string;
    // What the last check failed with, reduced. Not set when the last check got its answer
    private _checkError?: INodeCheckError;
    /**
     * The error of the last check, reduced to code, errno and sqlState. Undefined when the last
     * check got its answer, whatever the validator then said, and before the first check.
     * An empty object stands for a failure the package made itself. stopTimerCheck() does not
     * clear it. A new object on every read
     */
    public get checkError(): INodeCheckError | undefined {
        return this._checkError && { ...this._checkError };
    }
    // Status check timeout: a check slower than the longest check interval counts as failed
    // With a healthCheck block it is the timeout of the block
    private readonly _checkTimeout: number;

    private _timer: Timer;
    // goes up at every stopTimerCheck()
    private _checkRun: number = 0;
    // Time to next check status. Time in ms
    private _nextCheckTime: number = 10000;
    // Check status time range [min, max]
    private readonly timerCheckRange: ITimerCheckRange;
    // Check status multiplier to change next time check depends on error or success
    private readonly timerCheckMultiplier: number;
    // The healthCheck block of the node. With it the node is checked at a fixed interval,
    // goes down after `fall` failed checks and comes back after `rise` passed ones, and the
    // two legacy keys above are not read. Its `passive` lets the connection failures of the
    // queries of the app count too, see realFailure(). Without it the node keeps the legacy
    // check
    private readonly _healthCheck?: IHealthCheck;

    /**
     * @param pool pool of what status to check
     * @param settings pool settings
     * @param active default pool active status before status check
     */
    constructor(pool: Pool, settings: IUserPoolSettings, active: boolean) {
        this._pool = pool;

        this.active = active;

        this._isValid = false;
        this._loadScore = 100000;

        this._validator = new Validator(this, settings.validators);
        this._loadFactor = new LoadFactor(settings.loadFactors);

        // complete by now: Settings.mixSettings filled both halves from the defaults
        this.timerCheckRange = settings.timerCheckRange as ITimerCheckRange;
        this.timerCheckMultiplier = settings.timerCheckMultiplier;
        // queryTimeout 0 means no timeout
        this._checkTimeout = Math.min(settings.queryTimeout || Infinity, this.timerCheckRange.end);
        // the second failed check in a row takes a node of the legacy check out
        this._fall = 2;
        // complete as well: Settings.mixSettings filled in every key the app left out
        this._healthCheck = settings.healthCheck as IHealthCheck | undefined;
        // mysql2: a connectionLimit of 0 means no limit
        this._rerunLimit = Math.min(
            settings.connectionLimit || PoolStatus._mostReruns, PoolStatus._mostReruns
        );
        if (this._healthCheck) {
            this._checkTimeout = this._healthCheck.timeout;
            this._fall = this._healthCheck.fall;
            this._warnIgnoredKeys(settings);
        }
        this._timer = new Timer(this.checkStatus.bind(this));
        Logger.debug("Pool status configured");
    }

    /**
     * Mark the status active and let the check timer run again after stopTimerCheck().
     * The pool calls it when it connects, before its first check. It starts no check itself
     */
    public startTimerCheck() {
        this.active = true;
        // With a healthCheck block a connect() starts both runs again, and its first pass
        // brings the node up by itself, see _upAfter(). The legacy check keeps its count
        // of failed checks over a disconnect()
        if (this._healthCheck) {
            this._failedChecks = 0;
            // for a state that reads clean, no more: the first pass brings the node up
            // whatever this count is, and the check that next takes it down resets it.
            // So no test can tell this line is here
            this._passedChecks = 0;
            this._passedSinceStart = false;
            // a refusal from before does not slow the checks of this connect() down
            this._slowRetry = false;
            // and what passive health kept of the life before
            this._holdOff = 0;
            this._decides = undefined;
            // The check of this connect() reads the count before it ends: when a call of
            // the app loses its connection while that check is out and the check then
            // meets a lost one too, a count left from before would use up its runs
            this._reruns = 0;
        }
        this._timer.activate();
        Logger.debug("Check status in pool started");
    }

    /**
     * Tell the app once that this node does not read the legacy check keys it wrote, on the
     * host or in the default pool settings. A default of the schema is not something it wrote
     * @param settings pool settings
     * @private
     */
    private _warnIgnoredKeys(settings: IUserPoolSettings) {
        const ignored = Settings.ignoredCheckKeys(settings);
        if (!ignored.length) return;
        Logger.warn("Pool " + this._pool.name + ": the settings hold a healthCheck block for " +
            "this node, so " + ignored.join(" and ") + (ignored.length > 1 ? " are" : " is") +
            " ignored", { pool: this._pool.name, ignored });
    }

    private static _logDropped(host: string): void {
        Logger.debug("Dropped the result of a status check that outlived its connection in host: " + host);
    }

    /**
     * Stop pool check status timer.
     * A check that is still running after this changes nothing and reports nothing
     */
    public stopTimerCheck() {
        this._checkRun++;
        this._checksOut = 0;
        this._timer.dispose();
        Logger.info("Check status in pool stopped");
    }

    /**
     * Check pool status
     * @param outcome filled when this check is recorded, so the caller knows how its own check
     * ended. Left as it is by a check that is dropped, and when no check runs
     */
    public async checkStatus(outcome: ICheckOutcome = {}) {
        const queryTimer = new QueryTimer();
        // a check that outlives stopTimerCheck() belongs to a connection that is gone
        const run = this._checkRun;
        // true while the status query is out. Only what the query is rejected with can come
        // from mysql2, the socket or the server
        let asking = false;
        // for passive health: this check is out, from here until it sets the next one
        let out = false;
        const over = () => {
            if (out) this._checksOut--;
            out = false;
        };
        try {
            if (!this.active) return;
            this._checksOut++;
            out = true;
            // a check that runs again is the same check to the hold-off
            if (this._holdOff > 0 && !this._reruns) this._holdOff--;

            Logger.debug("checking pool status in host: " + this._pool.host);
            queryTimer.start();

            // one timer for the whole check, including waiting for a free connection
            let checkTimer: NodeJS.Timeout;
            let result: GlobalStatusResult[];
            try {
                asking = true;
                result = await Promise.race([
                    this._pool.query(`SHOW GLOBAL STATUS;`, this._checkOptions()),
                    new Promise<never>((_, reject) => {
                        checkTimer = setTimeout(() => reject(new Error("Status check timeout")), this._checkTimeout);
                    })
                ]) as GlobalStatusResult[];
                asking = false;
            } finally {
                clearTimeout(checkTimer);
            }
            if (run !== this._checkRun) return PoolStatus._logDropped(this._pool.host);

            // the query ran: the error of an earlier check is over, whatever the validator says
            this._checkError = undefined;
            // and so is the slow pace of a refusal: the server took this login
            this._slowRetry = false;
            outcome.recorded = true;
            queryTimer.end();
            this._queryTime = queryTimer.get();

            const passed = this._validator.check(result);
            // The legacy check sets the node to what the validators said, here. With a
            // healthCheck block a no takes the node down here as well, and a pass counts
            // at the end only, so a check that throws below brings no node up
            // the reason is for the log of a node with the block, which gets here with a no
            if (!this._healthCheck || !passed) this._setValid(passed, 'validator');
            if (this._healthCheck) {
                // what this check found, which is not always the state of the node
                Logger.debug("Did the validators accept the status of host " + this._pool.host +
                    "? -> " + passed.toString(), { pool: this._pool.name, passed });
            } else {
                // the line of 4.6.0, as it was: there the state is what the validators said
                Logger.debug("Is status ok in host " + this._pool.host + "? -> " + this._isValid.toString())
            }
            this._loadScore = this._loadFactor.check(result);
            Logger.debug("Load score by checking status in host " + this._pool.host + " is " + this._loadScore);
            this._failedChecks = 0;
            // the node answered: what a call of the app ran into before says nothing any more
            this._decides = undefined;
            this._reruns = 0;
            if (this._healthCheck) {
                // read before _upAfter() marks the pass
                const reason = this._passedSinceStart ? 'rise' : 'first_pass';
                this._setValid(this._upAfter(passed), reason);
            }

            over();
            this.nextCheckStatus()
            // the last step: nothing after it can fail and make this check count twice.
            // The result is what this check said: a down node that passed stays down
            // until the `rise`th pass
            this._recordCheck(passed ? 'valid' : 'invalid');
        } catch (err) {
            if (run !== this._checkRun) return PoolStatus._logDropped(this._pool.host);
            // an error thrown after the answer came is one of the package's own code
            this._checkError = asking ? PoolStatus._reduce(err) : {};
            // the caller gets an object of its own
            Object.assign(outcome, { recorded: true, checkError: { ...this._checkError } });
            Logger.error("Something wrong while checking status in host: " + this._pool.host +
                ".\n Message: " + PoolStatus._errorText(err));
            this._passedChecks = 0;
            // With a healthCheck block a refused login takes the node down with this one
            // check, whatever `fall` is, and the next check waits authRetryInterval. Any
            // other failure counts toward `fall`. One failed check is enough as well when
            // a call of the app lost its connection, got none in time or found no route,
            // since the last check that got its answer. But for a check that only met one more connection
            // that was lost: it says nothing about the node, counts toward nothing and
            // runs again at once
            const refused = this._refused();
            const again = !refused && this._metLostConnection();
            if (!again) {
                this._failedChecks++;
                if (refused) {
                    this._setValid(false, 'refusal');
                } else if (this._failedChecks >= this._fall) {
                    this._setValid(false, 'fall');
                } else if (this._decides) {
                    this._setValid(false, PoolStatus._decided[this._decides]);
                }
                // a check that had to decide did: the checks after it count as any check
                this._decides = undefined;
                this._reruns = 0;
            }
            // The slow pace starts with a refusal and holds over the failed checks after
            // it that got no answer: a server can hold its refusal back for longer than a
            // check waits. An error with an answer in it ends the slow pace
            this._slowRetry = refused || (this._slowRetry && this._unanswered());

            queryTimer.end();
            this._queryTime = queryTimer.get();

            try {
                over();
                if (again) {
                    this._checkAgain();
                } else {
                    this.nextCheckStatus(true, this._slowRetry)
                }
                this._emitCheckFailed(err);
            } finally {
                // the last step here too, after the next check is set and the app was told.
                // In a finally, so a step that throws above cannot leave the check uncounted
                this._recordCheck('error');
            }
        }
    }

    /**
     * Set the state of the node. With a healthCheck block a change of the state is logged,
     * one line each: a warn when the node goes down, an info when it comes back. A check
     * that leaves the node as it was logs nothing here, and neither does the legacy check
     * @param valid the state after this check
     * @param reason what moved the node: `fall` failed checks in a row, a login or account
     * the server refused, a validator that said no, the first pass since connect() or
     * `rise` passes in a row. From passive health: a connection the node refused the app,
     * or a failed check after a connection the app lost, did not get in time or found no
     * route for
     * @private
     */
    private _setValid(
        valid: boolean,
        reason: 'fall' | 'refusal' | 'validator' | 'first_pass' | 'rise' | PassiveReason
    ) {
        const changed = valid !== this._isValid;
        this._isValid = valid;
        if (!changed || !this._healthCheck) return;

        const pool = "Pool " + this._pool.name;
        const meta = { pool: this._pool.name, valid, reason };
        if (reason === 'fall') {
            Logger.warn(pool + " went down: " + this._fall +
                (this._fall > 1 ? " failed checks in a row" : " failed check"), meta);
        } else if (reason === 'refusal') {
            // the errno says which refusal it was, retryIn how many ms the next check is
            // away. The message of the server stays out
            Logger.warn(pool + " went down: the server refused the login of its check", {
                ...meta, errno: this._checkError.errno,
                retryIn: this._healthCheck.authRetryInterval
            });
        } else if (reason === 'validator') {
            Logger.warn(pool + " went down: a validator said no", meta);
        } else if (reason === 'passive_connect') {
            // the code says which connection error it was. Its message stays out
            Logger.warn(pool + " went down: the app could not open a connection to it",
                { ...meta, code: this._passiveCode });
        } else if (reason === 'passive_lost') {
            Logger.warn(pool + " went down: the app lost a connection to it and the check " +
                "after that failed", { ...meta, code: this._passiveCode });
        } else if (reason === 'passive_timeout') {
            Logger.warn(pool + " went down: the app got no connection to it in time and " +
                "the check after that failed", { ...meta, code: this._passiveCode });
        } else if (reason === 'passive_unreachable') {
            Logger.warn(pool + " went down: the app found no route to it and the check " +
                "after that found none either", { ...meta, code: this._passiveCode });
        } else if (reason === 'first_pass') {
            Logger.info(pool + " is up: its first check since connect() passed", meta);
        } else {
            const rise = this._healthCheck.rise;
            Logger.info(pool + " is back up: " + rise +
                (rise > 1 ? " checks passed in a row" : " check passed"), meta);
        }
    }

    // The errno of the errors a server refuses a login or an account with. A node that
    // answers a check with one of them goes on refusing until someone acts on the server,
    // and each new login can count against the account there. 4150 and 4151 are of
    // MariaDB. 1226 is not here: a server also answers with it while the account has too
    // many connections open, which passes when one of them closes
    private static readonly _refusals: ReadonlySet<number> = new Set([
        1044, 1045, 1049, 1129, 1130, 1862, 3118, 3159, 3955, 4150, 4151
    ]);

    /**
     * Whether the check that just failed was refused by the server: a node with a
     * healthCheck block whose reduced checkError has an errno of the list. Never by `fatal`:
     * mysql2 marks a login refused on an open connection as fatal, and one refused on a new
     * connection not. A failure the package made has an empty checkError and is none.
     * Always false for a node of the legacy check
     * @private
     */
    private _refused(): boolean {
        return !!this._healthCheck && PoolStatus._refusals.has(this._checkError.errno);
    }

    // The options objects of the status queries of every node. Pool.query() tells a query
    // of a check from a query of the app by them
    private static readonly _checkQueries = new WeakSet<object>();

    /**
     * The options of the status query of one check: no cache, and the timeout of the check.
     * A new object each time, kept so that isCheckQuery() knows it
     * @private
     */
    private _checkOptions(): IQueryOptions {
        const options = { redis: false, timeout: this._checkTimeout };
        PoolStatus._checkQueries.add(options);
        return options;
    }

    /**
     * Whether these query options are the ones a health check made for its status query.
     * Told by the object itself, never by what it holds: an app that sends the same sql
     * with the same options sends a query of its own
     * @param queryOptions the options Pool.query() was called with
     */
    public static isCheckQuery(queryOptions?: IQueryOptions): boolean {
        // a WeakSet knows objects only
        return Object(queryOptions) === queryOptions
            && PoolStatus._checkQueries.has(queryOptions);
    }

    // The code of a connection the node refused: nothing listens on the port. The node,
    // or a balancer in its place, answered and said no
    private static readonly _refusedCode = 'ECONNREFUSED';
    // The codes of a connection that no route led to: the host, or its network. This host
    // or a router on the path says so, the node was never asked, and the connections the
    // pool holds can go on working. ENOTFOUND is not here, and neither is EAI_AGAIN: a
    // name lookup is shared by every node the app addresses by name, so a resolver that
    // fails for a moment says nothing about one node
    private static readonly _unreachableCodes: ReadonlySet<string> = new Set([
        'EHOSTUNREACH', 'ENETUNREACH'
    ]);
    // No answer in time: the connect timeout of mysql2, or the one of the socket. Nobody
    // said the node is gone. The timer of mysql2 covers the whole login and is due as well
    // after this process stalled for that long, whatever the node answered
    private static readonly _timeoutCode = 'ETIMEDOUT';
    // The codes of a connection that was lost: closed by the server as mysql2 reports it,
    // reset, and written to after the other side closed it
    private static readonly _lostCodes: ReadonlySet<string> = new Set([
        'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE'
    ]);

    // what a call of the app ran into, for the debug line of the check that starts
    private static readonly _ranInto = {
        connect: "could not open a connection",
        timeout: "got no connection in time",
        unreachable: "found no route for a connection",
        lost: "lost a connection"
    };
    // the reason a node goes down with when the check that had to decide failed
    private static readonly _decided: {
        [kind in 'lost' | 'timeout' | 'unreachable']: PassiveReason
    } = { lost: 'passive_lost', timeout: 'passive_timeout', unreachable: 'passive_unreachable' };

    /**
     * What a failed query or getConnection() of the app says about the node, if anything.
     * Only an error of the network does: `fatal` is true, the code is one of those named
     * above, the error has no errno of a server, and neither the package nor the app made
     * it. Never by `fatal` alone: mysql2 marks a refused change
     * of user, a TLS or auth plugin error and a protocol error as fatal too, and none of
     * them says the node is gone. The place decides the kind as well
     * @param error what the call was rejected with
     * @param opening true when the error came instead of a connection, false when it came
     * on a connection the pool had handed out
     * @returns the kind, and the code it was told by, read once: a second read of a field
     * of the error could throw. While a connection was being opened the kind is 'connect'
     * for ECONNREFUSED, 'unreachable' for EHOSTUNREACH and ENETUNREACH and 'timeout' for
     * ETIMEDOUT. 'lost' for any of those codes on a connection that was handed out, and for
     * a code of the lost kind at either place. Otherwise undefined
     * @private
     */
    private static _connectionFailure(
        error: any, opening: boolean
    ): { kind: 'connect' | 'unreachable' | 'timeout' | 'lost', code: string } | undefined {
        try {
            if (Object(error) !== error || PoolStatus._ownErrors.has(error)) return undefined;
            // read all three before any is used, as _reduce() does
            const { fatal, code, errno } = error;
            if (fatal !== true) return undefined;
            // Node gives an error of a socket a negative errno. A positive one is a server's
            if (Number.isInteger(errno) && errno > 0) return undefined;
            const connect = code === PoolStatus._refusedCode;
            const unreachable = PoolStatus._unreachableCodes.has(code);
            const timeout = code === PoolStatus._timeoutCode;
            if (opening && connect) return { kind: 'connect', code };
            if (opening && unreachable) return { kind: 'unreachable', code };
            if (opening && timeout) return { kind: 'timeout', code };
            const lost = connect || unreachable || timeout || PoolStatus._lostCodes.has(code);
            return lost ? { kind: 'lost', code } : undefined;
        } catch (unreadable) {
            return undefined;
        }
    }

    /**
     * Passive health. Pool tells here every query, transaction and getConnection() of the
     * app that failed, never the query of a check. It does something for a node with a
     * healthCheck block whose `passive` is true, while the pool is connected and the node is
     * up, and only for an error _connectionFailure() knows:
     * - a connection the node refused takes the node down at once. It comes back as after
     *   any check that took it down: by `rise` passes, or its first pass since connect()
     * - a connection that was lost, one that was not there within the connect timeout and
     *   one that no route led to leave the node up. The next check that fails takes it down, whatever `fall` is,
     *   and a check that gets its answer ends that
     * Both start a check at once, in place of the one the timer was waiting for, unless a
     * check is out or passive health started one since the last check of the timer.
     * A check that has to decide and meets one more lost connection runs again, see
     * _metLostConnection().
     * It never brings a node up, sets no checkError and emits no event.
     * It starts no check during the slow pace of a refused login either: a node the server
     * refused is down, and stays down until a check got its answer, which ends that pace
     * @param error what the call was rejected with, as mysql2 handed it out
     * @param opening true when the error came instead of a connection
     */
    public realFailure(error: unknown, opening: boolean): void {
        const block = this._healthCheck;
        if (!block || !block.passive || !this.active || !this._isValid) return;
        const failure = PoolStatus._connectionFailure(error, opening);
        if (!failure) return;

        const { kind, code } = failure;
        this._passiveCode = code;
        if (kind === 'connect') {
            // the passes before this do not count toward `rise`
            this._passedChecks = 0;
            this._setValid(false, 'passive_connect');
        } else {
            this._decides = kind;
        }

        // a check that is about to run again is out too
        if (this._checksOut > 0 || this._reruns > 0 || this._holdOff > 0) return;
        // the check this starts, and the next one of the timer
        this._holdOff = 2;
        Logger.debug("Pool " + this._pool.name + ": the app " + PoolStatus._ranInto[kind] +
            ", the next check starts now", { pool: this._pool.name, passive: kind, code });
        // In place of the pending check. It does nothing once stopTimerCheck() ran
        this._timer.start(0);
    }

    // The most times a check that decides runs again. A pool with no limit, or with a
    // larger one, stops here: each run is a new login when no idle connection is left,
    // and a server blocks a host after max_connect_errors logins in a row that broke off,
    // 100 by default. 50 stays under half of that. A pool that holds more forgotten
    // connections than this can lose a healthy node until its checks pass again
    private static readonly _mostReruns = 50;

    /**
     * Whether the check that just failed has to decide and only met another connection
     * that was lost: its error has a code of the lost kind. A path that forgot its idle
     * flows resets every pooled connection at its next use, the one of the check as the
     * one of the app, and none of those resets says the node is gone. mysql2 hands out
     * the idle connection it got back last and drops a broken one from the pool, so each
     * run uses one of them up, and the run after the last opens a new connection, which
     * gets an answer of the node. A pool holds connectionLimit connections at most and
     * the app's own call met one of them, so that many runs are more than enough. A
     * check that still fails this way after them decides: the node resets new
     * connections too
     * @private
     */
    private _metLostConnection(): boolean {
        return this._decides !== undefined && this._reruns < this._rerunLimit
            && PoolStatus._lostCodes.has(this._checkError.code);
    }

    /**
     * Run the check that decides once more, at once: the run that just failed met a
     * connection that was lost. The checks of the timer go on after the run that ends it
     * @private
     */
    private _checkAgain() {
        this._reruns++;
        Logger.debug("Pool " + this._pool.name + ": the check met a connection that was " +
            "lost as well, it runs again now",
            { pool: this._pool.name, rerun: this._reruns, code: this._checkError.code });
        this._timer.start(0);
    }

    /**
     * Whether the check that just failed got no answer about the node: it ran into the
     * timeout of the check or failed with another error the package made, so its checkError
     * is empty, or it ran into a connect timeout, ETIMEDOUT from mysql2 or the socket.
     * After a refusal such a check keeps the slow pace. Every other error ends it: mysql2,
     * the socket or the server said something that is no refusal, as a refused or a lost
     * connection and too many connections do
     * @private
     */
    private _unanswered(): boolean {
        const { code, errno, sqlState } = this._checkError;
        if (code === 'ETIMEDOUT') return true;
        return code === undefined && errno === undefined && sqlState === undefined;
    }

    /**
     * Whether a node with a healthCheck block is up after a check that got its answer and
     * ended without an error. A validator that says no takes it down at once. A pass keeps
     * an up node up, and brings a down one back when it is the `rise`th in a row. The first
     * pass since connect() is enough by itself, so a start, and a node that was down at the
     * start, are not slowed
     * @param passed what the validators said
     * @private
     */
    private _upAfter(passed: boolean): boolean {
        this._passedChecks = passed ? this._passedChecks + 1 : 0;
        if (!passed) return false;
        const first = !this._passedSinceStart;
        this._passedSinceStart = true;
        return this._isValid || first || this._passedChecks >= this._healthCheck.rise;
    }

    /**
     * Record this check as a metric: how long it took and how it ended. Only a check that
     * is recorded in the status gets here, never one that was dropped or did not run.
     * Both branches call it last, so nothing a record does comes before what the check does
     * @param result how the check ended
     * @private
     */
    private _recordCheck(result: HealthCheckResult) {
        Metrics.recordHealthCheck(this._queryTime, {
            poolName: this._pool.name,
            host: this._pool.host,
            port: this._pool.port,
            result,
            checkError: this._checkError
        });
    }

    /**
     * Hand the error of a failed check to the app, with the id of the pool.
     * It runs after the next check is set, and a listener that throws is logged,
     * so a listener that throws cannot stop the checks. An async listener that rejects
     * is not caught here: that rejection belongs to the app.
     * A check that was still running when the pool was stopped reports nothing
     * @param err error of the failed check
     * @private
     */
    private _emitCheckFailed(err: any) {
        if (!this.active) return;
        try {
            Events.emit('pool_check_failed', err, this._pool.id);
        } catch (listenerError) {
            Logger.error("A pool_check_failed listener threw in host: " + this._pool.host +
                ".\n Message: " + PoolStatus._errorText(listenerError && listenerError.stack ? listenerError.stack : listenerError));
        }
    }

    /**
     * Text of whatever a check or a listener threw. Not every error has a message:
     * a rejection may be undefined, and a refused connection to a host with several
     * addresses is an AggregateError with a code and an empty message
     * @private
     */
    private static _errorText(err: any): string {
        try {
            return String((err && (err.message || err.code)) || err);
        } catch (unreadable) {
            // an object without a prototype, a symbol, a getter that throws
            return 'unreadable error';
        }
    }

    /**
     * Start timer for next pool check status
     * @param downgrade downgrade time for next check pool status?
     * @param slow whether the next check waits authRetryInterval: the server refused the
     * login of this check, or of an earlier one and no check got an answer since. Only a
     * node with a healthCheck block is ever slow in this sense, see _slowRetry
     * @private
     */
    private nextCheckStatus(downgrade: boolean = false, slow: boolean = false) {
        // A healthCheck block: the same wait after every check, but while the slow pace of
        // a refusal holds. Each new login can count against the account at the server, so
        // those checks wait authRetryInterval, as it is written: it may be shorter than
        // the interval
        if (this._healthCheck) {
            const { interval, authRetryInterval } = this._healthCheck;
            return this._timer.start(slow ? authRetryInterval : interval);
        }
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = Utils.clamp(this._nextCheckTime, this.timerCheckRange.start, this.timerCheckRange.end)

        this._timer.start(this._nextCheckTime);
    }

    // Errors the package made itself, or the app handed to it. A code on one of them is not
    // a code of mysql2, the socket or the server, so a check does not report it
    private static readonly _ownErrors = new WeakSet<object>();

    /**
     * Mark an error as made by this package, or handed to it by the app, not by mysql2, the
     * socket or the server. A check that fails with it reports an empty checkError, so a code
     * the package invented never looks like an answer of the server. The error itself is not
     * changed. A value that is no object is left alone
     * @param error the error to mark
     * @returns the same error
     */
    public static ownError<T>(error: T): T {
        // a WeakSet takes objects only
        if (Object(error) === error) PoolStatus._ownErrors.add(error as unknown as object);
        return error;
    }

    /**
     * What a check reports of the error its status query was rejected with: code when it is a
     * string, errno when it is an integer, sqlState when it is a string. Never the message,
     * which can hold the user name. An empty object for an error marked with ownError(), for a
     * value that is no object, and for one whose fields throw when read
     * @private
     */
    private static _reduce(err: any): INodeCheckError {
        const reduced: INodeCheckError = {};
        try {
            if (err === null || err === undefined || PoolStatus._ownErrors.has(err)) return reduced;
            // read all three before any is kept: a field that throws leaves nothing half taken
            const { code, errno, sqlState } = err;
            if (typeof code === 'string') reduced.code = code;
            if (Number.isInteger(errno)) reduced.errno = errno;
            if (typeof sqlState === 'string') reduced.sqlState = sqlState;
            return reduced;
        } catch (unreadable) {
            return {};
        }
    }
}
