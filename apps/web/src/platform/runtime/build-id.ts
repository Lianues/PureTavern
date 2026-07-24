declare const __PURE_TAVERN_BUILD_ID__: string;

export const RUNTIME_BUILD_ID =
  typeof __PURE_TAVERN_BUILD_ID__ === 'string' ? __PURE_TAVERN_BUILD_ID__ : 'development';
