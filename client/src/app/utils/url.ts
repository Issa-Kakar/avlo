export const getHttpBase = () => `${location.protocol}//${location.host}`;
export const getWsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
