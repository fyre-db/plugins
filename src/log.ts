import debug from 'debug';

const root = debug('plugins');

function createLogger(module: string) {
  const base = root.extend(module);
  return Object.assign(base, {
    warn: base.extend('warn'),
    error: base.extend('error'),
  });
}

export const log = {
  app: createLogger('app'),
  auth: createLogger('auth'),
  cloud: createLogger('cloud'),
  crypto: createLogger('crypto'),
  storage: {
    google: createLogger('storage:google'),
    local: createLogger('storage:local'),
    onedrive: createLogger('storage:onedrive'),
  },
  transform: createLogger('transform'),
};
