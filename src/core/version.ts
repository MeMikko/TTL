/** Build version, injected by the Docker build (GIT_SHA); "dev" locally. */
export const VERSION = process.env.GIT_SHA ?? 'dev';
