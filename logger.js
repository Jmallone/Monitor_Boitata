const fs = require('fs');
const path = require('path');
const pino = require('pino');
const pinoHttp = require('pino-http');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const level = process.env.LOG_LEVEL || 'info';

// Transporta logs para stdout e para arquivo JSON simultaneamente
const transport = pino.transport({
    targets: [
        {
            target: 'pino/file',
            level,
            options: {
                destination: path.join(logsDir, 'app.log'),
                mkdir: true,
            },
        },
        {
            target: 'pino/file',
            level,
            options: {
                destination: 1, // stdout
            },
        },
    ],
});

const logger = pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
}, transport);

const httpLogger = pinoHttp({
    logger,
    customProps: (req, res) => ({
        requestId: req.id,
    }),
});

// --- Rotina de limpeza do arquivo de log a cada 5 dias ---
const appLogPath = path.join(logsDir, 'app.log');
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

function truncateLogFileIfExists() {
    try {
        if (fs.existsSync(appLogPath)) {
            fs.truncateSync(appLogPath, 0);
            logger.info({ file: appLogPath }, 'app.log truncado (limpeza programada a cada 5 dias)');
        }
    } catch (err) {
        logger.error({ err }, 'Falha ao truncar app.log');
    }
}

setInterval(truncateLogFileIfExists, FIVE_DAYS_MS);

module.exports = { logger, httpLogger }; 