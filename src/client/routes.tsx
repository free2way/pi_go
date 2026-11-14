import { lazy } from "react";

export const AccountsPage = lazy(() => import("./AccountsPage").then((module) => ({ default: module.AccountsPage })));
export const BackupsPage = lazy(() => import("./BackupsPage").then((module) => ({ default: module.BackupsPage })));
export const AgilePage = lazy(() => import("./AgilePage").then((module) => ({ default: module.AgilePage })));
export const DecisionsPanel = lazy(() => import("./DecisionsPanel").then((module) => ({ default: module.DecisionsPanel })));
export const HistoryPage = lazy(() => import("./HistoryPage").then((module) => ({ default: module.HistoryPage })));
export const ModelsPage = lazy(() => import("./ModelsPage").then((module) => ({ default: module.ModelsPage })));
export const ReleaseSettingsPage = lazy(() => import("./ReleaseSettingsPage").then((module) => ({ default: module.ReleaseSettingsPage })));
export const SystemStatusPage = lazy(() => import("./SystemStatusPage").then((module) => ({ default: module.SystemStatusPage })));
export const WorkspacesPage = lazy(() => import("./WorkspacesPage").then((module) => ({ default: module.WorkspacesPage })));
