import type { AgentProfile, AgentProfileRole, AgentTeam } from "../shared/types.js";
import { newId, type Db } from "./db.js";

type ProfileRow = {
  id: string;
  owner_id: string;
  name: string;
  role: AgentProfileRole;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
};

type TeamRow = {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export class AgentTeamError extends Error {
  constructor(
    message: string,
    readonly code: "PROFILE_NOT_FOUND" | "TEAM_NOT_FOUND" | "PROFILE_IN_USE" | "NAME_IN_USE" | "INVALID_TEAM",
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AgentTeamError";
  }
}

function profileFromRow(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    role: row.role,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function teamFromRow(row: TeamRow, profiles: AgentProfile[]): AgentTeam {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    profiles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function nameConflict(): AgentTeamError {
  return new AgentTeamError("Name is already in use", "NAME_IN_USE", 409);
}

export class AgentTeamService {
  constructor(private readonly db: Db) {}

  async listProfiles(ownerId: string): Promise<AgentProfile[]> {
    const rows = (await this.db.query(
      "SELECT * FROM agent_profiles WHERE owner_id = $1 ORDER BY updated_at DESC, id ASC",
      [ownerId],
    )).rows as ProfileRow[];
    return rows.map(profileFromRow);
  }

  async getProfile(ownerId: string, id: string): Promise<AgentProfile> {
    const row = (await this.db.query(
      "SELECT * FROM agent_profiles WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    )).rows[0] as ProfileRow | undefined;
    if (!row) throw new AgentTeamError("Agent profile not found", "PROFILE_NOT_FOUND", 404);
    return profileFromRow(row);
  }

  async createProfile(ownerId: string, input: {
    name: string;
    role: AgentProfileRole;
    provider: string;
    model: string;
  }): Promise<AgentProfile> {
    await this.assertNameAvailable("agent_profiles", ownerId, input.name);
    const now = new Date().toISOString();
    const id = newId("profile");
    try {
      await this.db.query(
        `INSERT INTO agent_profiles (id, owner_id, name, role, provider, model, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, ownerId, input.name, input.role, input.provider, input.model, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw nameConflict();
      throw error;
    }
    return this.getProfile(ownerId, id);
  }

  async updateProfile(ownerId: string, id: string, input: {
    name: string;
    role: AgentProfileRole;
    provider: string;
    model: string;
  }): Promise<AgentProfile> {
    await this.getProfile(ownerId, id);
    await this.assertNameAvailable("agent_profiles", ownerId, input.name, id);
    const now = new Date().toISOString();
    try {
      await this.db.query(
        `UPDATE agent_profiles
         SET name = $3, role = $4, provider = $5, model = $6, updated_at = $7
         WHERE id = $1 AND owner_id = $2`,
        [id, ownerId, input.name, input.role, input.provider, input.model, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw nameConflict();
      throw error;
    }
    return this.getProfile(ownerId, id);
  }

  async deleteProfile(ownerId: string, id: string): Promise<void> {
    await this.getProfile(ownerId, id);
    const membership = (await this.db.query(
      `SELECT m.team_id
       FROM agent_team_members m
       JOIN agent_teams t ON t.id = m.team_id
       WHERE m.profile_id = $1 AND t.owner_id = $2
       LIMIT 1`,
      [id, ownerId],
    )).rows[0];
    if (membership) {
      throw new AgentTeamError("Agent profile is used by a team", "PROFILE_IN_USE", 409);
    }
    await this.db.query("DELETE FROM agent_profiles WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  }

  async listTeams(ownerId: string): Promise<AgentTeam[]> {
    const rows = (await this.db.query(
      `SELECT
         t.id AS team_id, t.owner_id AS team_owner_id, t.name AS team_name,
         t.created_at AS team_created_at, t.updated_at AS team_updated_at,
         p.id AS profile_id, p.owner_id AS profile_owner_id, p.name AS profile_name,
         p.role AS profile_role, p.provider AS profile_provider, p.model AS profile_model,
         p.created_at AS profile_created_at, p.updated_at AS profile_updated_at,
         m.ordinal AS member_ordinal
       FROM agent_teams t
       LEFT JOIN agent_team_members m ON m.team_id = t.id
       LEFT JOIN agent_profiles p ON p.id = m.profile_id
       WHERE t.owner_id = $1
       ORDER BY t.updated_at DESC, t.id ASC, m.ordinal ASC`,
      [ownerId],
    )).rows;
    const teams = new Map<string, AgentTeam>();
    for (const row of rows) {
      const id = String(row.team_id);
      let team = teams.get(id);
      if (!team) {
        team = teamFromRow({
          id,
          owner_id: String(row.team_owner_id),
          name: String(row.team_name),
          created_at: String(row.team_created_at),
          updated_at: String(row.team_updated_at),
        }, []);
        teams.set(id, team);
      }
      if (row.profile_id !== null && row.profile_id !== undefined) {
        team.profiles.push(profileFromRow({
          id: String(row.profile_id),
          owner_id: String(row.profile_owner_id),
          name: String(row.profile_name),
          role: String(row.profile_role) as AgentProfileRole,
          provider: String(row.profile_provider),
          model: String(row.profile_model),
          created_at: String(row.profile_created_at),
          updated_at: String(row.profile_updated_at),
        }));
      }
    }
    return [...teams.values()];
  }

  async getTeam(ownerId: string, id: string): Promise<AgentTeam> {
    const row = (await this.db.query(
      "SELECT * FROM agent_teams WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    )).rows[0] as TeamRow | undefined;
    if (!row) throw new AgentTeamError("Agent team not found", "TEAM_NOT_FOUND", 404);
    const profiles = (await this.db.query(
      `SELECT p.*
       FROM agent_team_members m
       JOIN agent_profiles p ON p.id = m.profile_id
       WHERE m.team_id = $1 AND p.owner_id = $2
       ORDER BY m.ordinal ASC`,
      [id, ownerId],
    )).rows as ProfileRow[];
    return teamFromRow(row, profiles.map(profileFromRow));
  }

  async createTeam(ownerId: string, input: { name: string; profileIds: string[] }): Promise<AgentTeam> {
    await this.assertNameAvailable("agent_teams", ownerId, input.name);
    const profiles = await this.requireOwnedProfiles(ownerId, input.profileIds);
    const now = new Date().toISOString();
    const id = newId("team");
    try {
      await this.db.withTransaction(async (tx) => {
        await tx.query(
          "INSERT INTO agent_teams (id, owner_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
          [id, ownerId, input.name, now],
        );
        for (const [ordinal, profile] of profiles.entries()) {
          await tx.query(
            "INSERT INTO agent_team_members (team_id, profile_id, ordinal) VALUES ($1, $2, $3)",
            [id, profile.id, ordinal],
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameConflict();
      throw error;
    }
    return this.getTeam(ownerId, id);
  }

  async updateTeam(ownerId: string, id: string, input: { name: string; profileIds: string[] }): Promise<AgentTeam> {
    await this.getTeam(ownerId, id);
    await this.assertNameAvailable("agent_teams", ownerId, input.name, id);
    const profiles = await this.requireOwnedProfiles(ownerId, input.profileIds);
    const now = new Date().toISOString();
    try {
      await this.db.withTransaction(async (tx) => {
        await tx.query(
          "UPDATE agent_teams SET name = $3, updated_at = $4 WHERE id = $1 AND owner_id = $2",
          [id, ownerId, input.name, now],
        );
        await tx.query("DELETE FROM agent_team_members WHERE team_id = $1", [id]);
        for (const [ordinal, profile] of profiles.entries()) {
          await tx.query(
            "INSERT INTO agent_team_members (team_id, profile_id, ordinal) VALUES ($1, $2, $3)",
            [id, profile.id, ordinal],
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameConflict();
      throw error;
    }
    return this.getTeam(ownerId, id);
  }

  async deleteTeam(ownerId: string, id: string): Promise<void> {
    await this.getTeam(ownerId, id);
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM agent_team_members WHERE team_id = $1", [id]);
      await tx.query("DELETE FROM agent_teams WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    });
  }

  private async requireOwnedProfiles(ownerId: string, profileIds: string[]): Promise<AgentProfile[]> {
    if (new Set(profileIds).size !== profileIds.length) {
      throw new AgentTeamError("A profile may appear only once in a team", "INVALID_TEAM", 400);
    }
    const profiles: AgentProfile[] = [];
    for (const id of profileIds) profiles.push(await this.getProfile(ownerId, id));
    return profiles;
  }

  private async assertNameAvailable(
    table: "agent_profiles" | "agent_teams",
    ownerId: string,
    name: string,
    excludingId?: string,
  ) {
    const row = (await this.db.query(
      `SELECT id FROM ${table} WHERE owner_id = $1 AND name = $2`,
      [ownerId, name],
    )).rows[0];
    if (row && String(row.id) !== excludingId) {
      throw nameConflict();
    }
  }
}
