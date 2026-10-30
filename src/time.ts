// The project clock is Hong Kong time. Stored Unix timestamps remain UTC.
export const PROJECT_TIMEZONE='Asia/Hong_Kong';
export const DAY_MS=86400000;
export const projectDay=(at=Date.now())=>new Date(at+8*3600000).toISOString().slice(0,10);
export const projectDayStart=(at=Date.now())=>Math.floor((at+8*3600000)/DAY_MS)*DAY_MS-8*3600000;
