import Logger, { consoleLogger } from '../../src/utils/Logger';
import { LOGLEVEL } from '../../src/types/LoggerInterfaces';

const makeLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('Logger with a logger of the app', () => {
    it('forwards messages at and above the configured level', () => {
        const logger = makeLogger();
        Logger.init(LOGLEVEL.WARN, logger);

        Logger.debug('d');
        Logger.info('i');
        Logger.warn('w', { a: 1 });
        Logger.error('e');

        expect(logger.debug).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('w', { a: 1 });
        expect(logger.error).toHaveBeenCalledWith('e');
    });

    it('lets everything through on debug', () => {
        const logger = makeLogger();
        Logger.init(LOGLEVEL.DEBUG, logger);

        Logger.debug('d');
        expect(logger.debug).toHaveBeenCalledWith('d');
    });

    it('lets nothing through on silent', () => {
        const logger = makeLogger();
        Logger.init(LOGLEVEL.SILENT, logger);

        Logger.error('e');
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('treats an unknown level as info', () => {
        const logger = makeLogger();
        Logger.init('DEBUG' as LOGLEVEL, logger);

        Logger.debug('d');
        Logger.info('i');
        expect(logger.debug).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith('i');
    });

    it('never throws when the logger throws', () => {
        const logger = makeLogger();
        logger.error.mockImplementation(() => { throw new Error('broken logger'); });
        Logger.init(LOGLEVEL.INFO, logger);

        expect(() => Logger.error('e')).not.toThrow();
    });

    it('handles the rejection of a logger that returns a rejected promise', async () => {
        const rejected = Promise.reject(new Error('async logger failed'));
        const handled = jest.spyOn(rejected, 'catch');
        const logger = makeLogger();
        logger.error.mockReturnValue(rejected);
        Logger.init(LOGLEVEL.INFO, logger);

        Logger.error('e');
        expect(handled).toHaveBeenCalledTimes(1);
        await new Promise(resolve => setImmediate(resolve));
    });

    it.each([
        ['an empty object', {}],
        ['a logger without debug', { info: jest.fn(), warn: jest.fn(), error: jest.fn() }],
        ['a string', 'console']
    ])('rejects %s as a logger', (_what, logger) => {
        expect(() => Logger.init(LOGLEVEL.INFO, logger as any)).toThrow('Invalid logger');
    });

    it('accepts the console itself', () => {
        const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
        Logger.init(LOGLEVEL.INFO, console);

        Logger.info('via console');
        expect(info).toHaveBeenCalledWith('via console');
        info.mockRestore();
    });
});

describe('Logger without a logger of the app', () => {
    let log: jest.SpyInstance;

    beforeEach(() => {
        log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        Logger.init(LOGLEVEL.INFO);
    });

    afterEach(() => log.mockRestore());

    it('writes one line per message to the console, with meta as JSON', () => {
        Logger.debug('hidden');
        Logger.info('shown', { pool: 'node1' });

        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0])
            .toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[info\] shown \{"pool":"node1"\}$/);
    });

    it('prints an Error with its stack', () => {
        Logger.error(new Error('boom'));

        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('[error] Error: boom\n    at ');
    });

    it.each([
        ['circular', (() => { const meta: any = {}; meta.self = meta; return meta; })()],
        ['BigInt', { big: BigInt(1) }],
        ['null', null]
    ])('still prints the line when meta is %s', (_kind, meta) => {
        Logger.info('kept', meta);

        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('[info] kept');
    });

    it('is the exported console logger', () => {
        consoleLogger.warn('direct');
        expect(log.mock.calls[0][0]).toContain('[warn] direct');
    });
});
