import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, name: string): Logger {
  return pino({
    name,
    level: config.LOG_LEVEL,
    // Never log credentials even if a caller passes a request object by mistake.
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.apiKey', '*.signature'],
      censor: '[redacted]',
    },
  });
}
