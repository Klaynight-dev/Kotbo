/**
 * Point d entree unique de l API dashboard.
 *
 * Les appels sont regroupes par domaine dans les modules voisins ; ce fichier
 * ne fait que les reexporter pour que les pages continuent d importer depuis
 * 'lib/api'.
 */
export { API_BASE_URL, DASHBOARD_WS_URL } from './client';
export * from './guild';
export * from './members';
export * from './regulation';
export * from './dailyAlgo';
export * from './staff';
export * from './analytics';
export * from './tutoring';
export * from './management';
export * from './admin';
export * from './invitations';
export * from './feedback';
export * from './moderation';
export * from './content';
export * from './hierarchies';
export * from './modules';
export * from './backups';
export * from './fun';
export * from './schedules';
export * from './economy';
export * from './mcp';
export * from './whiteLabel';
export * from './channelLinks';
export * from './channelHealth';
export * from './insights';
export * from './quests';
export * from './widgets';
export * from './homeWidgets';
export * from './userSettings';
export * from './changelog';
export * from './transcripts';
export * from './messageLogs';
export * from './raidProtection';
export * from './clans';
export * from './drops';
export * from './ghostMembers';
export * from './auditEvents';
export * from './workflows';
export * from './rankCard';
export * from './ranked';
export * from './simulation';
export * from './tickets';
export * from './serverTemplate';
export * from './billing';
export * from './servers';
export * from './adminAnalytics';
