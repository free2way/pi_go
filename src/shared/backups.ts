export interface BackupEntry {
  id: string;
  createdAt: string;
  state: "creating" | "ready" | "failed" | "deleted";
  bytes: number;
  files: number;
  protected: boolean;
}

export interface BackupOverview {
  backups: BackupEntry[];
  busy: boolean;
  encryption: "none";
  scope: "application-data";
  retention: { dailyDays: 7; weeklyWeeks: 4; monthlyMonths: 3; automaticDeletion: false };
  audit: Array<{ at: string; actorId: string; action: string; backupId: string }>;
}
